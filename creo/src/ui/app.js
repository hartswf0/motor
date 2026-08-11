// THE INTERFACE.
//
// One invitation: say something about this place. Everything else appears only
// when the world has something to show — a proposal, a conflict, an answer, a
// future. Every path through language has a wordless equivalent, because
// language must not become a new gatekeeper (§23).

import * as G from '../core/geom.js';
import { buildPlace, PLACES } from '../places/index.js';
import { listImported, loadImported, attribution } from '../places/imported.js';
import { openImportPanel, listCached, loadCached } from './importui.js';
import { proposeOperations, critique, hasKey, getConfig, setConfig, listModels, EFFORTS, lastCalls } from '../ai/operator.js';
import { MODES, MODE_ORDER, routeMode, STEP_LABELS } from '../ai/modes.js';
import { investigate, summarise } from '../ai/investigate.js';
import { Minimap, openLayers, openHelp, shouldShowHelp, hiddenTypes } from './chrome.js';
import { runWater } from '../sim/water.js';
import { toGeoJSON } from '../world/export.js';
import { World } from '../core/world.js';
import { makeContext } from '../lang/deixis.js';
import { describeRelations } from '../core/relations.js';
import { interpret } from '../lang/interpret.js';
import { plan, commitPlan } from '../world/ops.js';
import { ask } from '../world/query.js';
import { consequenceOf } from '../sim/consequence.js';
import { summarize } from '../world/certificate.js';
import { Renderer, perspective, lookAt, multiply, screenRay } from '../render/gl.js';
import { pick, rayToGround } from '../render/pick.js';

const $ = (id) => document.getElementById(id);
const canvas = $('world');

// A 3x phone turns a 430x932 screen into 1290x2796 pixels before a single
// triangle is drawn. Cap it; nobody can see the difference on a map.
export const MOBILE = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const DPR_CAP = MOBILE ? 1.35 : 1.8;

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
  // NOT `mode`: that is the drawing tool above. These two shared a name and the
  // second quietly won, so pressing D set the assistant's commitment to "draw"
  // and every later read of it threw. One word, two meanings, no error.
  commitment: 'auto',
  actingAs: null,
  busy: false,
  abort: false,
  labels: true,
  layersOff: new Set(),
  // NOT `plan` — that name already means the current proposal, and clearing a
  // proposal was switching the minimap off.
  showPlan: true,
};

const renderer = new Renderer(canvas);
renderer.dprCap = DPR_CAP;

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
  if (!S.world) return;            // the first place is still on its way
  const changed = new Set(S.world.journal.changedSince(Math.max(0, S.world.place.tick - 2)));
  const ghosts = currentGhosts();
  renderer.build(S.world, {
    ghosts,
    selection: S.selection,
    highlight: S.highlight,
    preserved: S.preserved,
    changed,
    fidelity: S.fidelity,
    hidden: hiddenTypes(S.layersOff),
    contours: !S.layersOff.has('contours'),
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

let minimap = null;
let frameErrors = 0;
let planDirty = true;
let lastInputAt = 0;
export const stats = { drawn: 0, skipped: 0, labels: 0 };

/** Something changed; the next frame should actually draw. */
function invalidate({ plan = false } = {}) {
  S.dirty = true;
  if (plan) planDirty = true;
}
/** A gesture is in flight, so keep drawing until it settles. */
const animating = () => Date.now() - lastInputAt < 220;

let frameErrorsShown = 0;
function frame() {
  // One bad frame used to kill the loop outright: rendering froze while the
  // world went on changing underneath, which looks like everything breaking at
  // once. Report it and keep drawing.
  try {
    // A world editor is not a game. When nothing has changed there is nothing
    // to draw, and drawing it anyway spends a phone's battery on a still image.
    if (!S.world) { requestAnimationFrame(frame); return; }
    if (!S.dirty && !animating()) { stats.skipped++; requestAnimationFrame(frame); return; }
    if (S.dirty) rebuild();
    renderer.draw(viewProj());
    drawLabels();
    stats.drawn++;
    if (minimap && S.showPlan && planDirty) {
      minimap.draw(S.world, { camera: S.cam, selection: S.selection, hidden: hiddenTypes(S.layersOff) });
      planDirty = false;
    }
  } catch (err) {
    if (frameErrors++ < 3) {
      console.error('frame failed:', err);
      toast(`Something went wrong drawing this: ${String(err.message).slice(0, 80)}`);
    }
    if (frameErrors === 4) console.error('further frame errors suppressed');
  }
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
    // Street names, where the source names them. A place whose streets are
    // nameless does not read as anywhere in particular.
    if (S.labels !== false && S.cam.dist < 700) {
      // One label per street, not one per fragment: a way clipped into four
      // pieces is still one road, and shouting its name four times is noise.
      const streets = new Map();
      for (const e of w.entities()) {
        if (!['road', 'path', 'rail', 'stream'].includes(e.type)) continue;
        if (!e.name) continue;
        const line = e.path;
        if (!line || line.length < 2) continue;
        const len = G.perimeter(line, false);
        if (len < S.cam.dist * 0.12) continue;              // too short to earn a label here
        const best = streets.get(e.name);
        if (!best || len > best.len) {
          const mid = line.length > 2 ? line[Math.floor(line.length / 2)] : G.lerp2(line[0], line[1], 0.5);
          streets.set(e.name, { len, mid, id: e.id });
        }
      }
      for (const [name, st] of streets) {
        wanted.push({ id: `st_${st.id}`, text: name, at: [st.mid[0], st.mid[1], w.place.groundAt(st.mid[0], st.mid[1]) + 0.6], cls: 'street' });
      }
    }
    // What OSM names at a point — shops, stops, clinics — close in only.
    if (S.labels !== false && S.cam.dist < 260) {
      const hiddenNow = hiddenTypes(S.layersOff);
      for (const e of w.entities()) {
        if (e.type !== 'marker' || hiddenNow.has('marker')) continue;
        const c = G.centroid(w.ringOf(e));
        wanted.push({ id: `poi_${e.id}`, text: e.name, at: [c[0], c[1], e.zTop + 0.8], cls: 'poi' });
      }
    }
  }
  for (const id of S.selection) {
    const e = w.get(id);
    if (!e) continue;
    const ring = w.ringOf(e);
    if (!ring) continue;
    wanted.push({ id: `sel_${id}`, text: labelFor(e), at: [...G.centroid(ring), e.zTop + 1.2], cls: 'sel' });
  }
  // Two people who spoke about the same spot must both stay readable — and no
  // label belongs underneath a button.
  const placed = [];
  const blocked = [
    { x0: 0, y0: 0, x1: 260, y1: 108 },                               // place chip + licence
    { x0: innerWidth - 220, y0: 0, x1: innerWidth, y1: 260 },          // name, undo, view tools
    { x0: innerWidth - 230, y0: innerHeight - 260, x1: innerWidth, y1: innerHeight }, // the plan
    { x0: 0, y0: innerHeight - 110, x1: innerWidth, y1: innerHeight }, // the say bar
  ];
  const inChrome = (x, y) => blocked.some((b) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1);
  // Rank, cap and reuse. Five hundred individually created DOM nodes per frame
  // is a compositor bill nobody agreed to pay.
  const rank = { sel: 0, obs: 1, poi: 2, street: 3 };
  wanted.sort((a, b) => (rank[a.cls] ?? 9) - (rank[b.cls] ?? 9));
  const limit = MOBILE ? 26 : 70;

  let used = 0;
  for (const l of wanted) {
    if (used >= limit) break;
    const p = project(l.at);
    if (!p || p[0] < -100 || p[0] > innerWidth + 100 || p[1] < 0 || p[1] > innerHeight) continue;
    if (inChrome(p[0], p[1])) continue;
    let y = p[1];
    for (let guard = 0; guard < 12; guard++) {
      const clash = placed.find((q) => Math.abs(q[0] - p[0]) < 150 && Math.abs(q[1] - y) < 22);
      if (!clash) break;
      y -= 24;
    }
    placed.push([p[0], y]);

    let d = host.children[used];
    if (!d) { d = document.createElement('div'); host.append(d); }
    const cls = `label ${l.cls}`;
    if (d.className !== cls) d.className = cls;
    if (d.textContent !== l.text) d.textContent = l.text;
    d.style.transform = `translate(-50%,-100%) translate(${p[0]}px,${y}px)`;
    d.hidden = false;
    used++;
  }
  for (let i = used; i < host.children.length; i++) host.children[i].hidden = true;
  stats.labels = used;
}

/**
 * How tall a thing is, and how much the ground under it falls.
 *
 * Once a building sits on the lowest ground it covers and clears the highest,
 * its vertical extent is height PLUS the fall of the hill. Reporting that
 * extent as "10.8 m high" for a three-storey house would be a new lie in place
 * of the old one. Height is measured from the ground the thing stands on; the
 * fall is said separately, because on a hillside it is the more interesting
 * number.
 */
function heightOf(e) {
  const ring = S.world.ringOf(e);
  const span = ring && ring.length >= 3
    ? G.groundSpan(ring, (x, y) => S.world.place.groundAt(x, y)) : null;
  const extent = e.zTop - e.zBase;
  if (!span) return { height: extent, fall: 0 };
  const fall = Math.max(0, span.hi - span.lo);
  return { height: Math.max(0, e.zTop - span.hi), fall, extent };
}

function labelFor(e) {
  const ring = S.world.ringOf(e);
  const bits = [e.name || (e.use ? `${e.use}` : e.type)];
  if (ring) {
    const ob = G.orientedBounds(ring);
    bits.push(`${ob.width.toFixed(1)}×${ob.depth.toFixed(1)} m`);
  }
  const { height, fall } = heightOf(e);
  if (height > 0.2) bits.push(`${height.toFixed(1)} m high`);
  if (fall > 0.5) bits.push(`on ground falling ${fall.toFixed(1)} m`);
  return bits.join(' · ');
}

// -------------------------------------------------------------- interaction --
let pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', (ev) => {
  lastInputAt = Date.now();
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY, t: Date.now() });
  if (pointers.size === 1) {
    if (S.mode === 'draw') {
      const p = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
      if (p) { S.stroke = [p]; S.strokeClosed = false; gesture = 'draw'; S.dirty = true; }
      return;
    }
    const hit = pick(S.world, rayAt(ev.clientX, ev.clientY), { fidelity: S.fidelity });
    if (hit.entity && S.selection.has(hit.entity.id)) {
      gesture = 'move';
      S.dragging = { id: hit.entity.id, from: hit.point, ring0: S.world.ringOf(hit.entity), path0: hit.entity.path };
      return;
    }
    // Dragging moves the map, the way every map anyone has used moves.
    // Turning the view is the deliberate gesture: right button, or hold shift.
    if (ev.button === 2 || ev.shiftKey || ev.ctrlKey || ev.altKey) gesture = 'orbit';
    else {
      const grab = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
      gesture = grab ? { kind: 'pan', grab } : 'orbit';
    }
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    gesture = {
      kind: 'pinch',
      d0: Math.hypot(a.x - b.x, a.y - b.y), dist0: S.cam.dist,
      mid: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      angle0: Math.atan2(b.y - a.y, b.x - a.x), yaw0: S.cam.yaw,
    };
  }
});
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

canvas.addEventListener('pointermove', (ev) => {
  const pt = pointers.get(ev.pointerId);
  if (!pt) return;
  lastInputAt = Date.now();
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
  if (gesture && gesture.kind === 'pan' && pointers.size === 1) {
    // Keep the ground the finger grabbed underneath the finger.
    const now = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
    if (now) {
      S.cam.target[0] += gesture.grab[0] - now[0];
      S.cam.target[1] += gesture.grab[1] - now[1];
      clampCamera();
    }
    return;
  }
  if (gesture === 'orbit' && pointers.size === 1) {
    S.cam.yaw -= dx * 0.006;
    S.cam.pitch = Math.max(0.14, Math.min(1.45, S.cam.pitch + dy * 0.005));
    clampCamera();
    return;
  }
  if (gesture && gesture.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    S.cam.dist = Math.max(12, Math.min(4000, gesture.dist0 * (gesture.d0 / Math.max(1, d))));
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    S.cam.yaw = gesture.yaw0 - (angle - gesture.angle0);
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    panBy(mid[0] - gesture.mid[0], mid[1] - gesture.mid[1]);
    gesture.mid = mid;
    clampCamera();
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
      // A freehand loop is not a polygon until it is made into one.
      const cleaned = G.cleanRing(S.stroke, Math.max(0.8, S.cam.dist * 0.004));
      if (!cleaned.ring) {
        S.stroke = null; S.strokeClosed = false; S.dirty = true;
        toast(cleaned.why || 'That did not read as an area — try a rounder loop.');
        setMode('select');
        return;
      }
      S.stroke = cleaned.ring;
      S.strokeClosed = true;
      toast(`${G.area(S.stroke).toFixed(0)} m² selected${cleaned.repaired ? ` — ${cleaned.why}` : ''}. Now say what about it, or press Note here.`);
    } else {
      S.strokeClosed = false;
      S.stroke = G.resample(S.stroke, Math.max(1, S.cam.dist * 0.006));
      toast(`Line: ${G.perimeter(S.stroke, false).toFixed(0)} m. Now say what about it.`);
    }
    setMode('select');
    S.dirty = true;
    showTools();
  } else if (gesture === 'move' && S.dragging) {
    commitDrag();
  } else if (moved < 6 && Date.now() - pt.t < 700 && pointers.size === 0) {
    tap(ev.clientX, ev.clientY, ev.shiftKey);
  }
  if (pointers.size === 0) gesture = null;
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  lastInputAt = Date.now();
  const before = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
  S.cam.dist = Math.max(12, Math.min(4000, S.cam.dist * (1 + Math.sign(ev.deltaY) * 0.11)));
  // Zoom toward what is under the cursor, not toward the middle of the screen.
  const after = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
  if (before && after) {
    S.cam.target[0] += before[0] - after[0];
    S.cam.target[1] += before[1] - after[1];
  }
  clampCamera();
  updateFidelity();
}, { passive: false });

/**
 * Keep the view somewhere a person can recover from: over the place rather than
 * out in the void, and above the ground rather than inside a building.
 */
function clampCamera() {
  const b = S.world.place.bounds();
  const margin = Math.max(80, Math.hypot(b[2] - b[0], b[3] - b[1]) * 0.15);
  S.cam.target[0] = Math.max(b[0] - margin, Math.min(b[2] + margin, S.cam.target[0]));
  S.cam.target[1] = Math.max(b[1] - margin, Math.min(b[3] + margin, S.cam.target[1]));
  S.cam.target[2] = S.world.place.groundAt(S.cam.target[0], S.cam.target[1]);
  S.cam.pitch = Math.max(0.14, Math.min(1.45, S.cam.pitch));
  planDirty = true;
  // never end up underground
  const e = eye();
  const floor = S.world.place.groundAt(e[0], e[1]) + 3;
  if (e[2] < floor) S.cam.pitch = Math.min(1.45, S.cam.pitch + (floor - e[2]) / Math.max(20, S.cam.dist));
  S.dirty = true;
  lastInputAt = Date.now();
}

/** Frame the whole place — the way back when you are lost. */
function frameAll() {
  frameWorld();
  toast('Showing the whole place.');
}

function panBy(dx, dy) {
  const scale = S.cam.dist * 0.0022;
  const yaw = S.cam.yaw;
  S.cam.target[0] += (Math.sin(yaw) * dx + Math.cos(yaw) * dy) * scale;
  S.cam.target[1] += (-Math.cos(yaw) * dx + Math.sin(yaw) * dy) * scale;
  clampCamera();
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
  intent.author = S.actingAs || S.author || 'unsigned';
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
  if (ev.key !== 'Enter') return;
  const v = ev.target.value;
  ev.target.value = '';
  if (!v.trim()) return;
  if (!hasKey()) { saySomething(v); return; }
  // The same sentence, at four different commitments.
  const once = ev.metaKey ? 'gauntlet' : ev.altKey ? 'deep' : ev.shiftKey ? 'think' : null;
  const previous = S.commitment;
  if (once) S.commitment = once;
  runAssistant(v).finally(() => { S.commitment = previous; });
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

// --------------------------------------------------------------- assistant --
/**
 * The assistant works the interface: it looks, points, circles, selects and then
 * says an ordinary sentence. Each operation runs through exactly the path a
 * human tap runs through, so its proposals still meet the certificate and still
 * wait for you to accept them.
 *
 * How hard it thinks is chosen by what was asked, not by a settings pane. And
 * while it works, the world is the progress bar: the drains light up, the causal
 * chain is traced, the rain actually runs.
 */
function showWorking(mode, step) {
  $('working').hidden = false;
  $('workingMode').textContent = MODES[mode]?.label || mode;
  $('workingStep').textContent = step;
}
function stopWorking() { $('working').hidden = true; S.busy = false; }
$('workingStop').onclick = () => { S.abort = true; stopWorking(); toast('Stopped.'); };

async function runAssistant(request) {
  if (!hasKey()) { openAIPanel(); return; }
  if (S.busy) { toast('Still working — press ■ to stop.'); return; }

  const ctx = context();
  const intent = interpret(request, ctx);
  const chosen = S.commitment === 'auto' ? routeMode(intent) : S.commitment;
  const mode = MODES[chosen] || MODES.think;
  if (!MODES[chosen]) console.warn(`[CREO] unknown commitment ${chosen}; using Think`);
  S.busy = true; S.abort = false;
  showWorking(chosen, STEP_LABELS.reading);

  try {
    // 1. LOOK. Real queries, with real consequences on screen.
    let findings = null;
    if (mode.investigate) {
      const res = await investigate(S.world, {
        focus: [...S.selection], point: S.pointer, question: request,
      }, (kind, visual) => {
        if (S.abort) return;
        showWorking(chosen, STEP_LABELS[kind] || kind);
        if (visual.highlight) S.highlight = new Set(visual.highlight);
        if (visual.overlay) S.overlay = visual.overlay;
        if (visual.trace) S.overlay = { ...(S.overlay || {}), trace: visual.trace };
        S.dirty = true;
      });
      if (S.abort) return;
      findings = summarise(res.findings);
    }

    // 2. THINK.
    showWorking(chosen, STEP_LABELS.asking);
    const view = {
      camera: { target: S.cam.target, dist: S.cam.dist },
      selection: [...S.selection], pointer: S.pointer,
      image: mode.vision === 'never' ? null : captureView(),
    };
    let result = await proposeOperations(S.world, request, view,
      { effort: mode.effort, vision: mode.vision, findings });
    if (S.abort) return;

    // 3. GAUNTLET: build it, look at it, let a fresh critic attack it.
    let verdict = null;
    if (mode.gauntlet && result.operations.length) {
      for (let round = 0; round < 2 && !S.abort; round++) {
        showWorking(chosen, STEP_LABELS.building);
        applyOperations(result.operations, chosen);
        await frameSettled();
        if (S.abort) return;

        showWorking(chosen, STEP_LABELS.rendering);
        const metrics = S.plan ? consequenceOf(S.world, S.plan).metrics : [];
        const shot = captureView();

        showWorking(chosen, STEP_LABELS.critic);
        verdict = await critique({
          goal: request,
          constraints: (intent.constraints || []).map((c) => c.raw || c.kind),
          metrics, image: shot, effort: mode.critic.effort,
        });
        if (S.abort) return;
        if (verdict.verdict === 'PASS') break;

        if (round === 0) {
          showWorking(chosen, STEP_LABELS.revising);
          discardProposal();
          result = await proposeOperations(S.world, request, view,
            { effort: mode.effort, vision: mode.vision, findings, critique: verdict.largestProblem });
        }
      }
    } else {
      applyOperations(result.operations, chosen);
    }

    stopWorking();
    const said = result.reasoning || '';
    if (!result.operations.length) { toast(said || 'Nothing here it could act on.'); return; }
    if (verdict) {
      toast(verdict.verdict === 'PASS'
        ? `Reviewed and stands: ${verdict.whatAParticipantWouldSee || said}`
        : `Still not right — ${verdict.largestProblem}. Shown anyway; judge for yourself.`);
    } else if (said) toast(said);
  } catch (err) {
    stopWorking();
    reportFailure('Could not answer', err);
  } finally {
    S.busy = false;
    $('working').hidden = true;
  }
}

// ------------------------------------------------------------------ vision --
// A WebGL2 drawing buffer is cleared the moment the frame is composited, so
// reading the canvas from ordinary code yields black — and black is worse than
// nothing, because the model then describes a void with confidence.
//
// The fix is not preserveDrawingBuffer (which taxes every frame for a picture
// taken rarely) and not waiting for a frame (requestAnimationFrame does not run
// in a backgrounded tab, so vision would silently vanish). Draw and read in the
// SAME synchronous task: the buffer cannot be cleared until this task yields.
function captureView(maxWidth = 1100, quality = 0.72) {
  try {
    rebuild();
    renderer.draw(viewProj());
    const c = document.createElement('canvas');
    const scale = Math.min(1, maxWidth / canvas.width);
    c.width = Math.round(canvas.width * scale);
    c.height = Math.round(canvas.height * scale);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    if (isBlank(c)) { console.warn('[CREO] view capture came back empty; sending no image'); return null; }
    return c.toDataURL('image/jpeg', quality);
  } catch (err) {
    console.warn('[CREO] view capture failed:', err);
    return null;
  }
}

/** True if every sampled pixel is identical — an empty read, not a dark scene. */
function isBlank(c) {
  try {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const step = Math.max(4, Math.floor(d.length / 4 / 500) * 4);
    let first = -1;
    for (let i = 0; i < d.length; i += step) {
      const v = d[i] + d[i + 1] * 256 + d[i + 2] * 65536;
      if (first < 0) first = v; else if (v !== first) return false;
    }
    return true;
  } catch { return false; }
}

/** Wait for one drawn frame, so a screenshot shows what was just done. */
const frameSettled = () => new Promise((r) => { S.dirty = true; requestAnimationFrame(() => requestAnimationFrame(r)); });

function discardProposal() {
  S.plan = null; S.altIndex = -1;
  hide('proposal');
  S.dirty = true;
}

function applyOperations(operations, modeKey) {
  S.actingAs = `${S.author || 'you'} + assistant`;
  for (const op of operations) {
    switch (op.op) {
      case 'look':
        S.cam.target = [op.at[0], op.at[1], S.world.place.groundAt(op.at[0], op.at[1])];
        if (op.distance) S.cam.dist = Math.max(20, Math.min(2000, op.distance));
        clampCamera(); updateFidelity();
        break;
      case 'point': S.pointer = op.at; break;
      case 'select': S.selection = new Set(op.ids); break;
      case 'circle': S.stroke = op.points; S.strokeClosed = true; S.pointer = G.centroid(op.points); break;
      case 'line': S.stroke = op.points; S.strokeClosed = false; break;
      case 'note': S.pointer = op.at; saySomething(op.text); break;
      case 'say': saySomething(op.text); break;
    }
    S.dirty = true;
  }
  S.actingAs = null;
  showTools();
}

// ------------------------------------------------------------ mode chooser --
function setMode_(key) {
  if (key !== 'auto' && !MODES[key]) key = 'auto';   // never trust a stale value
  S.commitment = key;
  const chip = $('modeChip');
  chip.textContent = key === 'auto' ? '✦ Auto' : `✦ ${MODES[key].label}`;
  chip.classList.toggle('set', key !== 'auto');
}

function openModeMenu() {
  document.querySelector('.modeMenu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'menu modeMenu';
  const r = $('modeChip').getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.bottom = `calc(${innerHeight - r.top + 8}px)`;

  const row = (key, label, hint) => {
    const b = document.createElement('button');
    b.className = S.commitment === key ? 'on' : '';
    b.innerHTML = `<span>${label}</span><span class="mHint">${hint}</span>`;
    b.onclick = () => { menu.remove(); setMode_(key); };
    menu.append(b);
  };
  row('auto', 'Auto', 'let CREO judge how much this needs');
  for (const k of MODE_ORDER) row(k, MODES[k].label, MODES[k].hint);

  const dev = document.createElement('button');
  dev.className = 'mHint';
  dev.style.borderTop = '1px solid var(--edge)';
  dev.style.marginTop = '4px';
  dev.textContent = 'The machinery…';
  dev.onclick = () => { menu.remove(); openAIPanel(); };
  menu.append(dev);

  document.body.append(menu);
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!menu.contains(e.target) && e.target !== $('modeChip')) { menu.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
}

// tap chooses how hard to think; hold reaches the machinery underneath
let holdTimer = null;
$('modeChip').addEventListener('pointerdown', () => {
  holdTimer = setTimeout(() => { holdTimer = null; openAIPanel(); }, 550);
});
$('modeChip').addEventListener('pointerup', () => {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; openModeMenu(); }
});
$('modeChip').addEventListener('pointerleave', () => { clearTimeout(holdTimer); holdTimer = null; });

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

// ----------------------------------------------------------------- subject --

// Windows, doors and furniture are parts of buildings, not contents of a piece
// of ground. Counting them as "things in this area" is technically true and
// humanly useless.
const PART_TYPES = new Set(['opening', 'furniture', 'room', 'wall']);

function entitiesInside(ring) {
  return S.world.entities().filter((e) => {
    if (PART_TYPES.has(e.type)) return false;
    const r = S.world.ringOf(e);
    return r && G.pointInRing(G.centroid(r), ring);
  });
}

/** What is here, said the way a person would say it: named things by name, the
 *  rest by kind and count. Never a list of internal ids. */
function describeContents(list) {
  if (!list.length) return 'Nothing is recorded inside this.';
  const named = list.filter((e) => e.name && !/^(House|Building|Tree|Window) ?\d*$/.test(e.name));
  const kinds = {};
  for (const e of list) {
    const k = e.use || e.subtype || e.type;
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const byKind = Object.entries(kinds).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
  const lines = [`${list.length} things: ${byKind.join(', ')}.`];
  if (named.length) lines.push(`By name: ${[...new Set(named.map((e) => e.name))].slice(0, 12).join(', ')}.`);
  const said = list.filter((e) => e.type === 'observation');
  if (said.length) lines.push(said.slice(0, 3).map((e) => `Someone said: \u201c${e.text || e.name}\u201d`).join('\n'));
  return lines.join('\n');
}
// Circle something, or tap it, and it becomes the SUBJECT: a thing that holds
// still while you talk about it. Everything typed here is about it, the answers
// stack up under it, and it does not need a model to be useful — most of these
// questions the world can answer out of its own record.

const SUBJECT_ASKS = {
  area: [
    ['What is in here?', 'what is here?'],
    ['Why does water collect?', 'why does water collect here?'],
    ['What could go here?', 'what could go here?'],
    ['It floods here', 'this always floods'],
    ['Three futures', 'show three radically different futures for this'],
  ],
  line: [
    ['Who walks this?', 'who walks here?'],
    ['People walk here', 'people actually walk here'],
    ['A path here', 'we need a path here'],
    ['What does it cross?', 'what does this cross?'],
  ],
  thing: [
    ['Why is it here?', 'why are you here?'],
    ['Who changed it?', 'who changed this?'],
    ['Does it flood?', 'does this flood?'],
    ['Taller', 'make this taller'],
    ['Keep', 'keep these'],
    ['Remove', 'remove this'],
    ['Three futures', 'show three radically different futures for this'],
  ],
};

/** What is true about the subject, counted rather than guessed. */
function subjectFacts() {
  const ids = [...S.selection];
  const out = [];
  if (S.stroke && !ids.length) {
    const inside = S.strokeClosed ? entitiesInside(S.stroke) : [];
    out.push(S.strokeClosed
      ? `${G.area(S.stroke).toFixed(0)} m², ${inside.length} thing${inside.length === 1 ? '' : 's'} inside`
      : `${G.perimeter(S.stroke, false).toFixed(0)} m long`);
    const kinds = {};
    for (const e of inside) kinds[e.type] = (kinds[e.type] || 0) + 1;
    const parts = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 4)
      .map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`);
    if (parts.length) out.push(parts.join(', '));
    const at = S.strokeClosed ? G.centroid(S.stroke) : S.stroke[0];
    if (S.world.place.terrain) {
      const g = S.world.place.terrain.slopeAt(at[0], at[1]);
      out.push(g.grade < 0.005 ? 'almost flat ground' : `ground falls ${(g.grade * 100).toFixed(1)}%`);
    }
    return out;
  }
  const e = ids.length === 1 && S.world.get(ids[0]);
  if (!e) return [`${ids.length} things chosen`];
  const ring = S.world.ringOf(e);
  if (ring) {
    const { height, fall } = heightOf(e);
    out.push(`${G.area(ring).toFixed(0)} m², ${height.toFixed(1)} m tall`
      + (fall > 0.5 ? ` on ground that falls ${fall.toFixed(1)} m across it` : ''));
  }
  out.push(`${String(e.epistemic || 'MODEL').toLowerCase()} · by ${e.provenance?.author || 'unknown'}`);
  const rels = describeRelations(S.world.place, e.id).filter((r) => r.ids.length);
  if (rels.length) out.push(rels.slice(0, 3).map((r) => `${r.kind} ${r.ids.length}`).join(', '));
  return out;
}

function threadAdd(q, a, src) {
  const t = $('subjectThread');
  t.hidden = false;
  const wrap = document.createElement('div');
  const qd = document.createElement('div'); qd.className = 'q'; qd.textContent = q;
  const ad = document.createElement('div'); ad.className = 'a'; ad.textContent = a;
  wrap.append(qd, ad);
  if (src) { const s = document.createElement('div'); s.className = 'src'; s.textContent = src; wrap.append(s); }
  t.append(wrap);
  t.scrollTop = t.scrollHeight;
  liftPlan();
}

/**
 * Ask about the subject. Without a key this is not a degraded mode: the world's
 * own query layer answers why-questions, provenance and measurements directly,
 * and DEEP-shaped questions run the real investigation. A key adds open-ended
 * language on top of that, not instead of it.
 */
async function askSubject(text) {
  if (!text.trim()) return;
  $('subjectInput').value = '';
  if (hasKey()) { threadAdd(text, '…', null); const t = $('subjectThread'); await runAssistant(text); t.lastChild?.remove(); return; }

  const intent = interpret(text, context());

  // "what is here?" about a drawn area is a contents question, and the world can
  // answer it exactly. Ask's generic OBSERVE path answers with entity ids.
  if (/^(what|who)('s| is| are)? ?(in |inside )?(here|this)\b/.test(text.trim().toLowerCase())) {
    const list = S.strokeClosed && S.stroke ? entitiesInside(S.stroke)
      : [...S.selection].map((id) => S.world.get(id)).filter(Boolean);
    threadAdd(text, describeContents(list), 'counted from the place');
    return;
  }

  if (['ASK', 'MEASURE', 'OBSERVE'].includes(intent.operation)) {
    const deep = ['why', 'why-not', 'what-blocks', 'where-fit'].includes(intent.question?.kind);
    if (deep) {
      threadAdd(text, 'looking…', null);
      const line = $('subjectThread').lastChild;
      const { findings } = await investigate(S.world, {
        focus: [...S.selection], point: S.pointer || (S.stroke && G.centroid(S.stroke)), question: text,
      }, (kind, v) => {
        line.querySelector('.a').textContent = STEP_LABELS[kind] || kind;
        if (v.highlight) S.highlight = new Set(v.highlight);
        if (v.overlay) S.overlay = v.overlay;
        S.dirty = true;
      });
      line.querySelector('.a').textContent = summarise(findings) || 'Nothing to report here.';
      line.querySelector('.src')?.remove();
      const s = document.createElement('div'); s.className = 'src';
      s.textContent = 'measured from the world — no model involved';
      line.append(s);
      return;
    }
    const a = ask(S.world, intent, {});
    threadAdd(text, a.text || '—', 'from the place\u2019s own record');
    return;
  }
  saySomething(text);
  threadAdd(text, 'Proposed — see the panel below.', null);
}

function showTools() {
  const ids = [...S.selection];
  const row = $('toolRow');
  const title = $('toolTitle');
  row.replaceChildren();

  if (!ids.length && !S.stroke) {
    hide('tools'); $('subjectThread').replaceChildren(); $('subjectThread').hidden = true;
    liftPlan(); return;
  }

  const mk = (text, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = `tool ${cls}`;
    b.textContent = text;
    b.onclick = fn;
    return b;
  };

  let kind = 'thing';
  if (S.stroke && !ids.length) kind = S.strokeClosed ? 'area' : 'line';
  title.textContent = kind === 'area' ? 'This area'
    : kind === 'line' ? 'This line'
      : ids.length === 1 ? labelFor(S.world.get(ids[0])) : `${ids.length} things`;
  $('subjectFacts').textContent = subjectFacts().join(' · ');
  $('subjectInput').placeholder = kind === 'thing' ? 'Ask about this' : `Ask about this ${kind}`;

  for (const [label, sentence] of SUBJECT_ASKS[kind]) row.append(mk(label, () => askSubject(sentence)));
  row.append(mk('Note here', () => openNote(), 'note'));
  if (kind === 'thing' && ids.length === 1) {
    const e = S.world.get(ids[0]);
    const num = document.createElement('label');
    num.className = 'tool num';
    num.textContent = 'Set width';
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.05'; inp.inputMode = 'decimal';
    const ring = S.world.ringOf(e);
    inp.value = ring ? G.orientedBounds(ring).width.toFixed(2) : '';
    inp.onchange = () => askSubject(`make this ${inp.value} m`);
    num.append(inp);
    row.append(num);
  }
  if (ids.length === 2) row.append(mk('Connect these', () => askSubject('connect these')));
  show('tools');
  liftPlan();
}

// The panel grows while an investigation streams into it, so watch its size
// rather than measuring once and hoping.
new ResizeObserver(() => liftPlan()).observe($('tools'));

/** Keep the plan clear of whatever the subject panel currently occupies. */
function liftPlan() {
  const t = $('tools');
  document.body.classList.toggle('subject', !t.hidden);
  // measure from the panel's actual top edge rather than adding up offsets, so
  // this stays right however tall the thread grows
  document.body.style.setProperty('--subjectH',
    t.hidden ? '0px' : `${Math.round(innerHeight - t.getBoundingClientRect().top + 8)}px`);
}

$('findChip').onclick = () => openFindPanel();
$('subjectSend').onclick = () => askSubject($('subjectInput').value);
$('subjectInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') askSubject(e.target.value);
  if (e.key === 'Escape') e.target.blur();
});
$('subjectClose').onclick = () => {
  S.selection.clear(); S.stroke = null; S.highlight.clear(); S.dirty = true;
  $('subjectThread').replaceChildren();
  showTools();
};

// -------------------------------------------------------------- go to one --
/**
 * Arriving in a district is not arriving at a site. Once a place is open the
 * next question is always "take me to THAT one" — a named building, a street, a
 * school — and until now the only way was to hunt for it by dragging.
 *
 * This searches what the place already knows, flies to it, and hands it over as
 * the subject, so the thing you went to see is the thing you are talking about.
 */
function openFindPanel() {
  document.querySelector('.findPanel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'menu findPanel';
  const r = $('placeName').getBoundingClientRect();
  panel.style.left = `${Math.max(8, r.left)}px`;
  panel.style.top = `${r.bottom + 8}px`;
  panel.style.width = 'min(360px, calc(100vw - 24px))';

  const label = document.createElement('div');
  label.className = 'menuLabel';
  label.textContent = 'Go to something in this place';
  const input = document.createElement('input');
  input.className = 'nameInput';
  input.placeholder = 'a building, a street, a shop…';
  const results = document.createElement('div');
  panel.append(label, input, results);
  document.body.append(panel);
  input.focus();

  const named = S.world.entities()
    .filter((e) => (e.name || e.use) && !['opening', 'furniture', 'room'].includes(e.type));

  const show = (q) => {
    results.replaceChildren();
    const needle = q.trim().toLowerCase();
    const scored = named.map((e) => {
      const hay = `${e.name || ''} ${e.use || ''} ${e.type}`.toLowerCase();
      if (!needle) return { e, score: e.name ? 1 : 0.4 };
      if (!hay.includes(needle)) return null;
      return { e, score: (e.name || '').toLowerCase().startsWith(needle) ? 3 : 2 };
    }).filter(Boolean);

    const ring = (e) => S.world.ringOf(e);
    scored.sort((a, b) => b.score - a.score
      || Math.abs(G.area(ring(b.e) || [])) - Math.abs(G.area(ring(a.e) || [])));

    for (const { e } of scored.slice(0, 12)) {
      const rg = ring(e);
      const b = document.createElement('button');
      const area = rg ? `${Math.abs(G.area(rg)).toFixed(0)} m²` : '';
      const { fall } = rg ? heightOf(e) : { fall: 0 };
      b.innerHTML = `${escapeHTML(e.name || e.use || e.type)}`
        + `<span class="sub">${e.type}${area ? ` · ${area}` : ''}`
        + `${fall > 0.5 ? ` · on ground falling ${fall.toFixed(1)} m` : ''}</span>`;
      b.onclick = () => { panel.remove(); goToEntity(e.id); };
      results.append(b);
    }
    if (!scored.length) {
      const none = document.createElement('div');
      none.className = 'importStatus';
      none.textContent = `nothing here called “${q}”`;
      results.append(none);
    }
  };
  show('');
  input.oninput = () => show(input.value);
  input.onkeydown = (ev) => {
    if (ev.key === 'Escape') panel.remove();
    if (ev.key === 'Enter') results.querySelector('button')?.click();
  };
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) {
    if (!panel.contains(ev.target)) { panel.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
}

/** Fly to one thing and make it the subject — arriving and attending are one act. */
function goToEntity(id) {
  const e = S.world.get(id);
  const ring = e && S.world.ringOf(e);
  if (!ring) return;
  const c = G.centroid(ring);
  const ob = G.orientedBounds(ring);
  S.cam.target = [c[0], c[1], S.world.place.groundAt(c[0], c[1])];
  // close enough to judge it against its ground, far enough to see what it meets
  S.cam.dist = Math.max(35, Math.min(320, Math.max(ob.width, ob.depth) * 2.6));
  S.cam.pitch = 0.42;
  clampCamera(); updateFidelity();
  S.selection = new Set([id]);
  S.dirty = true;
  showTools();
  const { height, fall } = heightOf(e);
  toast(fall > 0.5
    ? `${e.name || e.type} — ${height.toFixed(1)} m on ground that falls ${fall.toFixed(1)} m across it.`
    : `${e.name || e.type}.`);
}

const escapeHTML = (v) => String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// ------------------------------------------------------------------- setup --
// The key belongs on the page, not three gestures down. CREO works without one,
// so this says so rather than blocking the door.

// What this work actually wants, in order. The 5.6 line — sol, luna, terra — is
// what CREO is built against: spatial reasoning over a world it has to look at.
// Everything below is fallback, and gpt-4o is last on purpose: it was only ever
// the default because a stale id was shipped, never because it was the right
// tool for reasoning about ground and water.
const PREFERRED = [
  /(^|[-\/])gpt-?5\.6[-.]?sol\b|^sol\b/i,
  /(^|[-\/])gpt-?5\.6[-.]?luna\b|^luna\b/i,
  /(^|[-\/])gpt-?5\.6[-.]?terra\b|^terra\b/i,
  /(^|[-\/])gpt-?5\.6\b/i,
  /(^|[-\/])gpt-?5\b/i,
  /^o[34]\b/i,
  /(^|[-\/])gpt-4\.1\b/i,
];

function rankModel(m) {
  for (let i = 0; i < PREFERRED.length; i++) if (PREFERRED[i].test(m)) return i;
  if (/gpt-4o/i.test(m)) return PREFERRED.length + 1;
  return PREFERRED.length;
}

function openAIPanel() {
  const cfg = getConfig();
  $('setupKey').value = cfg.key || '';
  const sel = $('setupModel');
  const status = $('setupStatus');
  const setStatus = (m) => { status.textContent = m; };

  const fill = (models, chosen) => {
    sel.replaceChildren();
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      if (m === chosen) o.selected = true;
      sel.append(o);
    }
  };
  if (cfg.model) fill([cfg.model], cfg.model); else fill(['\u2014 add a key, then Refresh \u2014'], null);

  async function refresh() {
    const k = $('setupKey').value.trim();
    if (!k) { setStatus('paste a key first'); return; }
    setConfig({ key: k });
    setStatus('asking the endpoint what it has\u2026');
    try {
      const all = await listModels();
      const usable = all.filter((m) => !/embed|whisper|tts|dall|moderation|audio|realtime|image/.test(m))
        .sort((a, b) => rankModel(a) - rankModel(b) || b.localeCompare(a));
      if (!usable.length) { setStatus('the key works, but this endpoint offers no usable text models'); return; }
      fill(usable, cfg.model || usable[0]);
      const named = PREFERRED.find((p) => usable.some((m) => p.test(m)));
      setStatus(named
        ? `${usable.length} models \u2014 using ${usable[0]}, the most capable this key can reach`
        : `${usable.length} models \u2014 ${usable[0]}. No sol/luna/terra model on this key.`);
      if (!cfg.model) setConfig({ model: usable[0] });
    } catch (err) {
      setStatus(String(err.message).slice(0, 140));
    }
  }

  $('setupRefresh').onclick = refresh;
  $('setupKey').onchange = () => { setConfig({ key: $('setupKey').value.trim() }); refresh(); };
  sel.onchange = () => { setConfig({ model: sel.value }); setStatus(`using ${sel.value}`); };
  $('setupDone').onclick = () => {
    const k = $('setupKey').value.trim();
    if (k) setConfig({ key: k });
    if (sel.value && !sel.value.startsWith('\u2014')) setConfig({ model: sel.value });
    hide('setup');
    localStorage.setItem('creo.sawSetup', '1');
    setMode_(S.commitment);
    if (hasKey()) toast(`Ready \u2014 ${getConfig().model || 'model unset'}. Say anything about this place.`);
  };
  $('setupClose').onclick = () => { hide('setup'); localStorage.setItem('creo.sawSetup', '1'); };

  $('setup').classList.toggle('tucked', $('tools').hidden);
  show('setup');
  if (cfg.key && !cfg.model) refresh();
  else if (!cfg.key) $('setupKey').focus();
}

/**
 * Leaving a note should not require knowing which sentence the parser likes.
 * Type anything; it lands where you tapped, with your name on it.
 */
function openNote() {
  document.querySelector('.notePanel')?.remove();
  if (!S.pointer && !S.selection.size && !S.stroke) { toast('Tap a spot first, then leave your note.'); return; }
  const panel = document.createElement('div');
  panel.className = 'menu notePanel';
  panel.style.left = '12px';
  panel.style.bottom = `calc(150px + var(--safe))`;
  panel.style.width = 'min(400px, calc(100vw - 24px))';
  const label = document.createElement('div');
  label.className = 'menuLabel';
  label.textContent = 'What do you want to say about this spot?';
  const input = document.createElement('input');
  input.className = 'nameInput';
  input.placeholder = 'it floods here when the rain is bad';
  input.setAttribute('aria-label', 'Your note');
  const go = document.createElement('button');
  go.className = 'tool'; go.textContent = 'Leave it here';
  go.style.margin = '0 6px 6px';
  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    panel.remove();
    saySomething(text);
  };
  go.onclick = submit;
  input.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') panel.remove(); };
  panel.append(label, input, go);
  document.body.append(panel);
  input.focus();
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

$('fitBtn').onclick = () => frameAll();
$('planBtn').onclick = () => {
  S.showPlan = !S.showPlan;
  $('plan').hidden = !S.showPlan;
  $('planBtn').classList.toggle('on', S.showPlan);
};
$('layersBtn').onclick = () => openLayers({
  anchorEl: $('layersBtn'),
  off: S.layersOff,
  onChange: () => { S.dirty = true; },
  labelsOn: () => S.labels !== false,
  onLabels: () => { S.labels = S.labels === false; S.dirty = true; },
});
$('helpBtn').onclick = () => openHelp();

/**
 * Seeing the water was the whole point of modelling it, and it was reachable
 * only by saying the right sentence. It is a button now, with a scale, and it
 * says what it assumed.
 */
function toggleRain() {
  if (S.overlay?.kind === 'water') {
    S.overlay = null; S.dirty = true;
    $('waterLegend').hidden = true;
    $('rainBtn').classList.remove('on');
    return;
  }
  toast('Running the rain…');
  setTimeout(() => {
    const w = runWater(S.world, { rain: 'heavy' });
    S.overlay = { kind: 'water', water: w };
    S.dirty = true;
    $('rainBtn').classList.add('on');
    $('waterLegend').hidden = false;
    $('legendMax').textContent = `${(w.maxDepth * 100).toFixed(0)} cm`;
    const wet = [...w.exposure.entries()].filter(([, v]) => v.maxDepth > 0.05).length;
    $('legendNote').textContent =
      `${w.floodedArea.toFixed(0)} m² over 5 cm · ${wet} built things get wet. `
      + `${w.model.assumptions.rainfall_mm.heavy} mm over ${w.model.assumptions.duration_min} min, `
      + `${w.cell} m grid. Comparative, not survey: the direction is robust, the depth is not.`;
    toast(`Deepest ${(w.maxDepth * 100).toFixed(0)} cm · ${w.floodedArea.toFixed(0)} m² over 5 cm.`);
  }, 30);
}
$('rainBtn').onclick = toggleRain;

/** Take it away: what people said, and what was proposed, as ordinary GIS data. */
$('exportBtn').onclick = (ev) => {
  document.querySelector('.exportPanel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'menu exportPanel';
  const r = ev.currentTarget.getBoundingClientRect();
  panel.style.right = '12px';
  panel.style.top = `${r.bottom + 8}px`;
  const head = document.createElement('div');
  head.className = 'menuLabel';
  head.textContent = 'Take it away';
  panel.append(head);

  const notes = S.world.entities().filter((e) => e.type === 'observation');
  const mine = S.world.entities().filter((e) => e.epistemic === 'PROPOSED' || e.type === 'observation');

  const opt = (label, sub, fn) => {
    const b = document.createElement('button');
    b.innerHTML = `${label}<span class="sub">${sub}</span>`;
    b.onclick = () => { panel.remove(); fn(); };
    panel.append(b);
  };
  opt('What people said', `${notes.length} note${notes.length === 1 ? '' : 's'}, as GeoJSON`,
    () => download(filterGeoJSON((f) => f.properties.type === 'observation'), 'notes'));
  opt('Notes and proposals', `${mine.length} feature${mine.length === 1 ? '' : 's'} added to this place`,
    () => download(filterGeoJSON((f) => f.properties.type === 'observation' || f.properties.epistemic === 'PROPOSED'), 'proposals'));
  opt('This whole branch', `${S.world.entities().length} features, everything visible`,
    () => download(toGeoJSON(S.world), 'place'));
  opt('The event log', 'who changed what, when, and from which words',
    () => downloadText(JSON.stringify(S.world.journal.toJSON().events.map((e) => ({
      id: e.id, at: e.tick, by: e.author, did: e.label, said: e.utterance?.text || null, branch: e.branch,
    })), null, 2), 'history', 'json'));

  document.body.append(panel);
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
};

function filterGeoJSON(pred) {
  const fc = toGeoJSON(S.world);
  return { ...fc, features: fc.features.filter(pred) };
}
function download(geojson, kind) {
  if (!geojson.features.length) { toast('Nothing to take away yet.'); return; }
  downloadText(JSON.stringify(geojson, null, 2), kind, 'geojson');
  toast(`${geojson.features.length} features saved. Every one carries who said it and when.`);
}
function downloadText(text, kind, ext) {
  const name = `${S.placeKey}-${kind}-${new Date().toISOString().slice(0, 10)}.${ext}`;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

$('undoBtn').onclick = () => { const e = S.world.undo(); if (e) toast(`Undone: ${e.label}`); refreshChrome(); S.dirty = true; };
$('redoBtn').onclick = () => { const e = S.world.redo(); if (e) toast(`Redone: ${e.label}`); refreshChrome(); S.dirty = true; };

$('placeChip').onclick = async (ev) => {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.left = '12px';
  menu.style.top = `${ev.currentTarget.getBoundingClientRect().bottom + 8}px`;
  // "anywhere" comes first: it is the answer to the question the menu raises
  const anywhere = document.createElement('button');
  anywhere.innerHTML = `Take me anywhere…<span class="sub">search any street, district or village on Earth</span>`;
  anywhere.onclick = () => {
    menu.remove();
    openImportPanel({
      anchorEl: $('placeChip'),
      toast,
      onLoaded: (world, key, name) => adoptWorld(world, key, name),
    });
  };
  menu.append(anywhere);

  const cached = await listCached();
  for (const p of cached) {
    const b = document.createElement('button');
    b.className = p.key === S.placeKey ? 'on' : '';
    const c = p.counts || {};
    b.innerHTML = `${p.name}<span class="sub">${c.buildings || 0} buildings · ${(c.roads || 0) + (c.paths || 0)} ways · ${p.relief || 0} m relief</span>`;
    b.onclick = async () => { menu.remove(); adoptWorld(await loadCached(p.key), p.key, p.name); };
    menu.append(b);
  }

  const imported = await listImported();
  if (imported.length) {
    const h = document.createElement('div');
    h.className = 'menuLabel';
    h.textContent = 'Real places — OpenStreetMap';
    menu.append(h);
  }
  for (const p of imported) {
    const b = document.createElement('button');
    b.className = p.key === S.placeKey ? 'on' : '';
    const c = p.counts || {};
    b.innerHTML = `${p.name}<span class="sub">${c.buildings || 0} buildings · ${c.roads || 0} roads · ${p.relief || 0} m relief</span>`;
    b.onclick = () => { menu.remove(); loadPlace(p.key); };
    menu.append(b);
  }
  if (imported.length) {
    const h = document.createElement('div');
    h.className = 'menuLabel';
    h.textContent = 'Synthetic places — invented, for testing the loop';
    menu.append(h);
  }
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
  // Imported places are megabytes and already live in IndexedDB; only the
  // synthetic ones are small enough to mirror into localStorage.
  if (!PLACES.some((p) => p.key === S.placeKey)) return;
  try { localStorage.setItem(`creo.save.${S.placeKey}`, S.world.save()); } catch { /* quota */ }
}
/** Install a World that was just imported, without going back to disk. */
function adoptWorld(world, key, name) {
  S.world = world;
  S.placeKey = key;
  S.selection.clear(); S.highlight.clear(); S.stroke = null; S.plan = null; S.overlay = null; S.utterances = [];
  hide('proposal'); hide('answer'); hide('branches'); hide('tools');
  $('placeName').textContent = (name || world.place.name).split(' — ')[0].split(',')[0];
  const credit = attribution(world);
  $('attribution').textContent = credit || '';
  $('attribution').hidden = !credit;
  frameWorld();
  refreshChrome();
  S.dirty = true;
  localStorage.setItem('creo.place', key);
}

async function loadPlace(key) {
  S.placeKey = key;
  const saved = localStorage.getItem(`creo.save.${key}`);
  const synthetic = PLACES.some((p) => p.key === key);
  try {
    if (saved) S.world = World.load(saved);
    else if (synthetic) S.world = buildPlace(key);
    else {
      // A real place is either shipped with the repo or was pulled into this
      // browser. Ask the shipped index which it is rather than fetching a file
      // that is usually absent — that 404 fired on every single load of every
      // imported place, and a console full of expected errors is how a real one
      // goes unnoticed.
      const shipped = await listImported();
      S.world = shipped.some((p) => p.key === key)
        ? await loadImported(key)
        : await loadCached(key);
    }
  } catch (err) {
    // Most often this is a place imported in another browser, or cleared
    // storage: the key survives in localStorage and the file never existed.
    console.warn(`[CREO] could not open ${key}:`, err.message);
    S.placeKey = synthetic ? key : 'settlement';
    S.world = buildPlace(S.placeKey);
    if (!synthetic) {
      setTimeout(() => toast(`“${key}” is not in this browser any more — showing ${S.placeKey}. Use Take me anywhere to pull it again.`), 400);
    }
  }
  S.selection.clear(); S.highlight.clear(); S.stroke = null; S.plan = null; S.overlay = null; S.utterances = [];
  $('placeName').textContent = (PLACES.find((p) => p.key === S.placeKey)?.name || S.world.place.name).split(' — ')[0].split(',')[0];
  const credit = attribution(S.world);
  $('attribution').textContent = credit || '';
  $('attribution').hidden = !credit;
  hide('proposal'); hide('answer'); hide('branches'); hide('tools');
  frameWorld();
  refreshChrome();
  S.dirty = true;
  // remember what actually opened, not what was asked for — otherwise a place
  // that is gone gets written back and 404s again on every single reload
  localStorage.setItem('creo.place', S.placeKey);
}

// keyboard: every gesture has a key, because not everyone has a steady hand
addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  lastInputAt = Date.now();
  const k = ev.key.toLowerCase();
  if (k === 'z' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ev.shiftKey ? $('redoBtn').click() : $('undoBtn').click(); }
  else if (k === 'd') setMode(S.mode === 'draw' ? 'select' : 'draw');
  else if (k === 'b') showBranches();
  else if (k === 'l') { S.labels = S.labels === false; S.dirty = true; toast(S.labels === false ? 'Names hidden.' : 'Names shown.'); }
  else if (k === 'f') frameAll();
  else if (k === 'g') openFindPanel();
  else if (k === 'm') $('planBtn').click();
  else if (k === '?' || (k === '/' && ev.shiftKey)) { ev.preventDefault(); openHelp(); }
  else if (k === 'n') openNote();
  else if (k === 'r') toggleRain();
  else if (k === '/') { ev.preventDefault(); $('sayInput').focus(); }
  else if (k === 'escape') { S.selection.clear(); S.stroke = null; hide('tools'); hide('proposal'); S.plan = null; S.dirty = true; }
  // Arrows move you, which is what arrows do. Hold shift to turn and zoom.
  else if (k.startsWith('arrow')) {
    ev.preventDefault();
    if (ev.shiftKey) {
      if (k === 'arrowleft') S.cam.yaw -= 0.14;
      else if (k === 'arrowright') S.cam.yaw += 0.14;
      else if (k === 'arrowup') S.cam.dist *= 0.88;
      else S.cam.dist *= 1.14;
      clampCamera(); updateFidelity();
    } else {
      const step = S.cam.dist * 0.08;
      const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0;
      const dy = k === 'arrowup' ? step : k === 'arrowdown' ? -step : 0;
      const yaw = S.cam.yaw;
      S.cam.target[0] += Math.cos(yaw) * dy - Math.sin(yaw) * dx;
      S.cam.target[1] += Math.sin(yaw) * dy + Math.cos(yaw) * dx;
      clampCamera();
      setCrosshair(true);
    }
  }
  else if (k === '+' || k === '=') { S.cam.dist *= 0.88; clampCamera(); updateFidelity(); }
  else if (k === '-' || k === '_') { S.cam.dist *= 1.14; clampCamera(); updateFidelity(); }
  else if (k === 'enter' || k === ' ') {
    ev.preventDefault();
    setCrosshair(true);
    const r = canvas.getBoundingClientRect();
    tap(r.left + r.width / 2, r.top + r.height / 2, ev.shiftKey);
    const e = [...S.selection].map((id) => S.world.get(id)).filter(Boolean)[0];
    toast(e ? `Chose ${labelFor(e)}` : 'Nothing there — move with the arrow keys and try again.');
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
minimap = new Minimap($('planCanvas'), {
  onGo: (p) => {
    S.cam.target = [p[0], p[1], S.world.place.groundAt(p[0], p[1])];
    clampCamera();
  },
});
$('plan').hidden = false;
$('planBtn').classList.add('on');

// Order matters: everything that makes the interface usable happens before the
// one asynchronous step that can fail. Booting used to stop at a 404 and leave
// the whole app half-built, which read as "nothing works".
setMode_('auto');
setMode('select');
setAuthor(localStorage.getItem('creo.author') || '');
loadPlace(localStorage.getItem('creo.place') || 'settlement')
  .catch((err) => reportFailure('Could not open that place', err));
if (shouldShowHelp()) setTimeout(() => openHelp(), 600);
else if (!S.author) setTimeout(() => toast('Tap “add your name” at the top so the place can remember who changed what.'), 900);

// Offer the key once, on the page, where it can be seen. CREO is useful without
// one, so this is an offer rather than a gate — and it never asks twice.
if (!hasKey() && !localStorage.getItem('creo.sawSetup') && !shouldShowHelp()) {
  setTimeout(() => { if (!hasKey()) openAIPanel(); }, 1200);
}
requestAnimationFrame(frame);
addEventListener('resize', () => { invalidate({ plan: true }); });

// ------------------------------------------------------------------ errors --
// Nothing may fail silently. A dangling reference inside an async handler used
// to vanish into an unhandled rejection and the interface simply did nothing,
// which is the worst thing an interface can do.
function reportFailure(what, err) {
  const msg = String(err?.message || err || 'unknown');
  console.error(`[CREO] ${what}:`, err);
  toast(`${what}: ${msg.slice(0, 120)}`);
  S.lastError = { what, message: msg, stack: String(err?.stack || ''), at: new Date().toISOString() };
}
addEventListener('error', (e) => reportFailure('Something broke', e.error || e.message));
addEventListener('unhandledrejection', (e) => reportFailure('A request failed', e.reason));

// expose for the browser-side test harness (§29: the builder does not grade itself)
window.CREO = {
  S, saySomething, context, runAssistant,
  world: () => S.world,
  interpret: (t) => interpret(t, context()),
  plan: (t) => { const c = context(); return plan(S.world, interpret(t, c), c); },
  select: (ids) => { S.selection = new Set(ids); S.dirty = true; showTools(); },
  frameAll, openNote, openHelp, runAssistant, setMode: setMode_, openFindPanel, goToEntity,
  openSetup: openAIPanel, askSubject, showTools, rankModel, captureView, PREFERRED,
  _minimap: () => minimap,
  pointAt: (p) => { S.pointer = p; },
  draw: (pts, closed) => { S.stroke = pts; S.strokeClosed = closed; S.dirty = true; },
  commit: () => $('propCommit').click(),
  loadPlace,
};
