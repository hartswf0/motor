// The parts that stop a person getting lost: a plan you can see yourself on,
// control over what is drawn, and an answer to "what do I do".
//
// None of these are the world. They are aids to reaching it, and each one hides
// itself again when it has nothing to offer.

import * as G from '../core/geom.js';

// ------------------------------------------------------------------ layers --
export const LAYERS = [
  { key: 'buildings', label: 'Buildings', types: ['structure', 'wall', 'room', 'furniture'] },
  { key: 'streets', label: 'Streets & paths', types: ['road', 'path', 'rail', 'bridge'] },
  { key: 'water', label: 'Rivers, ponds & sea', types: ['water', 'stream', 'drain'] },
  { key: 'ground', label: 'Land use', types: ['surface', 'parcel', 'region'] },
  { key: 'nature', label: 'Trees', types: ['tree'] },
  { key: 'places', label: 'Shops & stops', types: ['marker'] },
  { key: 'notes', label: 'What people said', types: ['observation'] },
  { key: 'contours', label: 'Contour lines', types: [] },
];

export function hiddenTypes(off) {
  const out = new Set();
  for (const l of LAYERS) if (off.has(l.key)) for (const t of l.types) out.add(t);
  return out;
}

export function openLayers({ anchorEl, off, onChange, labelsOn, onLabels }) {
  document.querySelector('.layerPanel')?.remove();
  const panel = document.createElement('div');
  panel.className = 'menu layerPanel';
  const r = anchorEl.getBoundingClientRect();
  panel.style.right = '12px';
  panel.style.top = `${r.bottom + 8}px`;

  const head = document.createElement('div');
  head.className = 'menuLabel';
  head.textContent = 'What to show';
  panel.append(head);

  for (const l of LAYERS) {
    const row = document.createElement('button');
    const on = !off.has(l.key);
    row.className = on ? 'on' : '';
    row.innerHTML = `<span class="tick">${on ? '●' : '○'}</span> ${l.label}`;
    row.onclick = () => {
      if (off.has(l.key)) off.delete(l.key); else off.add(l.key);
      const nowOn = !off.has(l.key);
      row.className = nowOn ? 'on' : '';
      row.querySelector('.tick').textContent = nowOn ? '●' : '○';
      onChange();
    };
    panel.append(row);
  }

  const lab = document.createElement('button');
  const setLab = () => {
    lab.className = labelsOn() ? 'on' : '';
    lab.innerHTML = `<span class="tick">${labelsOn() ? '●' : '○'}</span> Names on the map`;
  };
  lab.onclick = () => { onLabels(); setLab(); };
  setLab();
  panel.append(lab);

  document.body.append(panel);
  setTimeout(() => document.addEventListener('pointerdown', function offClick(e) {
    if (!panel.contains(e.target) && e.target !== anchorEl) { panel.remove(); document.removeEventListener('pointerdown', offClick); }
  }), 0);
  return panel;
}

// ----------------------------------------------------------------- minimap --
/**
 * A plan of the whole place with your view drawn on it. This is the answer to
 * "parts run off board": you can always see where you are, what is out there,
 * and tap to go.
 */
export class Minimap {
  constructor(canvas, { onGo, onExplore = null }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onGo = onGo;
    // EXPLORE: the plan stops being a picture of what is loaded and becomes a
    // way of asking for what is not. It zooms out past the edge of the imported
    // ground, draws that ground as a lit rectangle in a dark surround, and lets
    // the window itself be dragged somewhere new — because "what is over there"
    // is the question a plan makes you want to ask, and until now the plan could
    // only answer with the edge of the tile.
    this.onExplore = onExplore;
    this.explore = false;
    this.proposed = null;      // [x, y] in the place's own metres
    this.bounds = null;
    this.dragging = false;

    const toWorld = (ev) => {
      const r = canvas.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width;
      const py = (ev.clientY - r.top) / r.height;
      const b = this.bounds;
      if (!b) return null;
      return [b[0] + px * (b[2] - b[0]), b[3] - py * (b[3] - b[1])];
    };
    canvas.addEventListener('pointerdown', (ev) => {
      this.dragging = true;
      // a pointer that is not active cannot be captured, and failing to capture
      // is not a reason to drop the gesture
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* fine */ }
      const p = toWorld(ev);
      if (!p) return;
      if (this.explore) { this.proposed = p; this.onExplore?.('move', p); }
      else onGo(p);
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!this.dragging) return;
      const p = toWorld(ev);
      if (!p) return;
      if (this.explore) { this.proposed = p; this.onExplore?.('move', p); }
      else onGo(p);
    });
    canvas.addEventListener('pointerup', () => {
      this.dragging = false;
      if (this.explore && this.proposed) this.onExplore?.('settle', this.proposed);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  draw(world, { camera, selection, hidden }) {
    const c = this.canvas;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    // fit the place, keeping the aspect honest — and in explore mode, pull back
    // so there is somewhere to drag TO
    const pb = world.place.bounds();
    const grow = this.explore ? 1.6 : 0;
    const b = grow
      ? [pb[0] - (pb[2] - pb[0]) * grow, pb[1] - (pb[3] - pb[1]) * grow,
         pb[2] + (pb[2] - pb[0]) * grow, pb[3] + (pb[3] - pb[1]) * grow]
      : pb;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    const pad = 6;
    const scale = Math.min((w - pad * 2) / Math.max(1, bw), (h - pad * 2) / Math.max(1, bh));
    const ox = (w - bw * scale) / 2 - b[0] * scale;
    const oy = (h - bh * scale) / 2 + b[3] * scale;
    this.bounds = [
      (0 - ox) / scale, (oy - h) / scale,
      (w - ox) / scale, oy / scale,
    ];
    const X = (x) => x * scale + ox;
    const Y = (y) => oy - y * scale;

    g.fillStyle = 'rgba(255,255,255,.045)';
    g.fillRect(X(pb[0]), Y(pb[3]), (pb[2] - pb[0]) * scale, (pb[3] - pb[1]) * scale);

    const drawRing = (ring, fill, stroke) => {
      g.beginPath();
      g.moveTo(X(ring[0][0]), Y(ring[0][1]));
      for (let i = 1; i < ring.length; i++) g.lineTo(X(ring[i][0]), Y(ring[i][1]));
      g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      if (stroke) { g.strokeStyle = stroke; g.stroke(); }
    };

    // ground, water, then streets, then buildings — cheapest legible order
    for (const e of world.entities()) {
      if (hidden.has(e.type)) continue;
      const ring = world.ringOf(e);
      if (!ring) continue;
      if (e.type === 'surface' || e.type === 'parcel') drawRing(ring, 'rgba(120,150,110,.16)');
      else if (e.type === 'water' || e.type === 'stream') drawRing(ring, 'rgba(90,150,200,.5)');
    }
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(220,225,230,.30)';
    g.beginPath();
    for (const e of world.entities()) {
      if (hidden.has(e.type)) continue;
      if (e.type !== 'road' && e.type !== 'path' && e.type !== 'rail') continue;
      const line = e.path;
      if (!line || line.length < 2) continue;
      g.moveTo(X(line[0][0]), Y(line[0][1]));
      for (let i = 1; i < line.length; i++) g.lineTo(X(line[i][0]), Y(line[i][1]));
    }
    g.stroke();

    g.fillStyle = 'rgba(200,190,175,.55)';
    for (const e of world.entities()) {
      if (hidden.has(e.type) || e.type !== 'structure') continue;
      const r = G.bbox(world.ringOf(e));
      g.fillRect(X(r[0]), Y(r[3]), Math.max(1, (r[2] - r[0]) * scale), Math.max(1, (r[3] - r[1]) * scale));
    }

    // what people said, and what is selected
    for (const e of world.entities()) {
      if (e.type !== 'observation' || hidden.has(e.type)) continue;
      const c2 = G.centroid(world.ringOf(e));
      g.fillStyle = '#f3c25e';
      g.beginPath(); g.arc(X(c2[0]), Y(c2[1]), 2.6, 0, 7); g.fill();
    }
    for (const id of selection) {
      const e = world.get(id);
      const ring = e && world.ringOf(e);
      if (!ring) continue;
      const c2 = G.centroid(ring);
      g.strokeStyle = '#ffe98c'; g.lineWidth = 1.5;
      g.beginPath(); g.arc(X(c2[0]), Y(c2[1]), 5, 0, 7); g.stroke();
    }

    // in explore mode: what is loaded, and where you are proposing to go
    if (this.explore) {
      g.save();
      g.strokeStyle = 'rgba(255,255,255,.35)';
      g.setLineDash([3, 3]);
      g.lineWidth = 1;
      g.strokeRect(X(pb[0]), Y(pb[3]), (pb[2] - pb[0]) * scale, (pb[3] - pb[1]) * scale);
      g.restore();
      if (this.proposed) {
        const w2 = (pb[2] - pb[0]) / 2, h2 = (pb[3] - pb[1]) / 2;
        const p = this.proposed;
        g.fillStyle = 'rgba(88,217,196,.14)';
        g.strokeStyle = '#58d9c4';
        g.lineWidth = 1.5;
        g.fillRect(X(p[0] - w2), Y(p[1] + h2), w2 * 2 * scale, h2 * 2 * scale);
        g.strokeRect(X(p[0] - w2), Y(p[1] + h2), w2 * 2 * scale, h2 * 2 * scale);
      }
    }

    // you are here, looking that way
    const t = camera.target;
    const half = 0.42;
    const reach = Math.max(18, camera.dist * 0.85) * scale;
    g.fillStyle = 'rgba(88,217,196,.20)';
    g.strokeStyle = 'rgba(88,217,196,.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(X(t[0]), Y(t[1]));
    for (let a = -half; a <= half; a += half / 6) {
      const dir = camera.yaw + Math.PI + a;
      g.lineTo(X(t[0] + Math.cos(dir) * reach * -1), Y(t[1] + Math.sin(dir) * reach * -1));
    }
    g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#58d9c4';
    g.beginPath(); g.arc(X(t[0]), Y(t[1]), 3, 0, 7); g.fill();
  }
}

// -------------------------------------------------------------------- help --
const HELP = [
  ['Move around', 'Drag the map to move. Scroll or pinch to zoom — it zooms toward where you point.'],
  ['Turn the view', 'Right-drag, or hold Shift and drag. Two fingers twist to turn on a touchscreen.'],
  ['Go to a building', 'Press <b>G</b> or ⌕ and type its name. It flies there and hands it to you, ready to talk about.'],
  ['Lost?', 'Press <b>F</b>, or the ⤢ button, to see the whole place again. The small plan shows where you are — tap it to go there.'],
  ['Choose something', 'Tap it. Its name and size appear, with things you can do to it.'],
  ['Say something', 'Tap the bar and speak plainly: <i>“this floods when it rains”</i>, <i>“we need a drain here”</i>, <i>“why is this here?”</i>'],
  ['Leave a note', 'Tap a spot, then <b>Note here</b>. What you write stays on that spot, with your name on it.'],
  ['Draw an area', 'Press <b>D</b> or ◌, then drag a loop. Draw a line instead and it becomes a route.'],
  ['Let it help', 'Press ✦ and describe what you want. It will circle, select and speak on your behalf — you still approve everything.'],
  ['Keyboard', '<b>arrows</b> move · <b>shift+arrows</b> turn and zoom · <b>Enter</b> choose what the crosshair is on · <b>N</b> note · <b>D</b> draw · <b>L</b> names · <b>M</b> plan · <b>F</b> fit · <b>?</b> this'],
];

export function openHelp() {
  document.querySelector('.helpOverlay')?.remove();
  const o = document.createElement('div');
  o.className = 'helpOverlay';
  const box = document.createElement('div');
  box.className = 'helpBox';
  box.innerHTML = `<h2>Using this</h2>${HELP.map(([k, v]) => `<div class="helpRow"><b>${k}</b><span>${v}</span></div>`).join('')}`;
  const close = document.createElement('button');
  close.className = 'btn primary';
  close.textContent = 'Got it';
  close.onclick = () => { o.remove(); localStorage.setItem('creo.seenHelp', '1'); };
  box.append(close);
  o.append(box);
  o.onclick = (e) => { if (e.target === o) close.click(); };
  document.body.append(o);
  return o;
}

export const shouldShowHelp = () => !localStorage.getItem('creo.seenHelp');
